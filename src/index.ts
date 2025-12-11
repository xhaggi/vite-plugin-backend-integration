import path from 'node:path'
import fs from 'fs/promises'
import colors from 'picocolors'
import type { DefaultTreeAdapterMap } from 'parse5'
import { parseFragment } from 'parse5'
import { OutputBundle, OutputChunk } from 'rollup'
import { Plugin, ResolvedConfig, normalizePath } from 'vite'

export interface Options {
  srcDir: string
  outDir?: string
  extension?: string
  base?: string
  assetTags?: AssetTags
}

export interface AssetTags {
  script: string
  preload: string
  stylesheet: string
}

interface ResourceChunk {
  file: string
  imports: string[]
  css: string[]
}
type ResourceBundle = Record<string, ResourceChunk>

const defaultTags: AssetTags = {
  script: '<script type="module" crossorigin src="{src}"></script>',
  preload: '<link rel="modulepreload" crossorigin href="{src}">',
  stylesheet: '<link rel="stylesheet" href="{src}">'
}

const moduleScriptRE = /([ \t]*)<script[^>]*type\s*=\s*["']?module["']?[^>]*><\/script>[\r\n]*/isg

const externalRE = /^(https?:)?\/\//
const isExternalUrl = (url: string): boolean => externalRE.test(url)

const plugin = (options: Options): Plugin => {
  let config: ResolvedConfig

  return {
    name: 'vite-plugin-backend-integration',

    async configResolved (resolvedConfig) {
      config = resolvedConfig
    },

    async transform (code, id) {
      if (isEntry(id)) {
        // Inject module preload polyfill only when configured and needed
        const { modulePreload } = config.build
        if (modulePreload !== false && modulePreload.polyfill) {
          code = `import 'vite/modulepreload-polyfill';\n${code}`
        }
        // Force rollup to keep this entry from being shared between other entry points.
        return { code: code, moduleSideEffects: 'no-treeshake' }
      }
    },

    async generateBundle (bundleOptions, bundle) {
      const tags = Object.assign({}, defaultTags, options.assetTags)

      const getEntryChunks = (bundle: OutputBundle): Record<string, OutputChunk> => {
        const entryChunks: Record<string, OutputChunk> = {}

        Object.values(bundle)
          .forEach(chunk => {
            if (chunk.type === 'chunk' && chunk.isEntry && chunk.facadeModuleId) {
              let name = normalizePath(path.relative(config.root, chunk.facadeModuleId))
              name = name.replace(/\0/g, '')
              entryChunks[name] = chunk
            }
          })

        return entryChunks
      }

      const getImportChunks = (chunk: OutputChunk, seen: Set<string> = new Set()): OutputChunk[] => {
        const chunks: OutputChunk[] = []
        chunk.imports.forEach(file => {
          const importee = bundle[file]
          if (importee && importee.type === 'chunk' && !seen.has(file)) {
            seen.add(file)
            // post-order traversal
            chunks.push(...getImportChunks(importee, seen))
            // skip empty chunks
            if (importee.code.trim().length > 0) {
              chunks.push(importee)
            }
          }
        })
        return chunks
      }

      const getCssChunks = (chunk: OutputChunk, analyzed: Set<OutputChunk> = new Set(), seen: Set<string> = new Set()): OutputChunk[] => {
        const chunks: OutputChunk[] = []
        if (!analyzed.has(chunk)) {
          analyzed.add(chunk)
          chunk.imports.forEach(file => {
            const importee = bundle[file]
            if (importee?.type === 'chunk') {
              chunks.push(...getCssChunks(importee, analyzed, seen))
            }
          })
        }

        chunk.viteMetadata?.importedCss.forEach(file => {
          if (!seen.has(file)) {
            seen.add(file)
            const cssChunk = {
              fileName: file
            } as OutputChunk
            chunks.push(cssChunk)
          }
        })

        return chunks
      }

      const getResourceBundle = (bundle: OutputBundle): ResourceBundle => {
        const entries = getEntryChunks(bundle)
        const resourceBundle: ResourceBundle = {}

        Object.entries(entries)
          .forEach(([key, chunk]) => {
            const importChunks = getImportChunks(chunk)
            const cssChunks = getCssChunks(chunk)

            resourceBundle[key] = {
              file: chunk.fileName,
              imports: importChunks.map(c => c.fileName),
              css: cssChunks.map(c => c.fileName)
            }
          })

        return resourceBundle
      }

      const optOutDir = options.outDir || options.srcDir
      const buildOutDir = path.isAbsolute(config.build.outDir) ? config.build.outDir : path.join(config.root, config.build.outDir)
      const srcDir = path.isAbsolute(options.srcDir) ? options.srcDir : path.join(config.root, options.srcDir)
      const outDir = path.isAbsolute(optOutDir) ? optOutDir : path.join(buildOutDir, optOutDir)
      const resourceBundle = getResourceBundle(bundle)
      const files = await findTemplateFiles(srcDir, options.extension || '.html')
      const maxFileNameLength = files.reduce((max, file) => Math.max(max, path.relative(srcDir, file).length), 0)

      for (const file of files) {
        const target = path.join(outDir, path.relative(srcDir, file))
        const buffer = await fs.readFile(file)
        let source = buffer.toString('utf8')

        if (moduleScriptRE.test(source)) {
          source = source.replace(moduleScriptRE, (element, indent) => {
            const fragment = parseFragment(element.trim())

            if (fragment.childNodes.length == 1) {
              const script = fragment.childNodes[0] as DefaultTreeAdapterMap['element']
              const src = script.attrs.find(a => a.name == 'src')?.value

              if (src) {
                if (src.endsWith('@vite/client')) {
                  // remove vite client import
                  return ''
                }

                // remove leading slash
                let entryPoint = new URL(src).pathname
                if (entryPoint.startsWith('/')) {
                  entryPoint = entryPoint.substring(1)
                }

                // check if entry point is found in bundle
                if (!(entryPoint in resourceBundle)) {
                  throw new Error(`Entry point ${entryPoint} not found.`)
                }

                const chunk = resourceBundle[entryPoint]
                const assetTags: string[] = []
                const assetsBase = getBaseUrl(config, options)
                const isAsync = script.attrs.some(a => a.name == 'async')

                const toOutputAssetFilePath = (filename: string) => {
                  return isExternalUrl(filename) ? filename : path.posix.join(assetsBase, filename)
                }

                // entry
                assetTags.push(toScriptTag(tags.script, toOutputAssetFilePath(chunk.file), isAsync))
                // preload modules
                assetTags.push(...chunk.imports.map(file => toLinkTag(tags.preload, toOutputAssetFilePath(file))))
                // css
                assetTags.push(...chunk.css.map(file => toLinkTag(tags.stylesheet, toOutputAssetFilePath(file))))

                return serializeTags(assetTags, indent)
              }
            }

            return element
          })
        }

        // write templates
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, source)

        // reporting
        printFileInfo(
          path.relative(config.root, outDir),
          path.relative(outDir, target),
          source,
          maxFileNameLength)
      }
    }
  }

  function isEntry (id: string) {
    const input = config.build?.rollupOptions?.input
    if (input instanceof Array) {
      return input.includes(id)
    } else if (input instanceof Object) {
      return Object.values(input).includes(id)
    } else {
      return input === id
    }
  }

  function printFileInfo (
    outDir: string,
    fileName: string,
    content: string | Uint8Array,
    maxLength: number
  ) {
    const kibs = content.length / 1024
    config.logger.info(
      `${colors.gray(colors.white(colors.dim(outDir + '/')))}${colors.blue(fileName.padEnd(maxLength + 2))} ${colors.dim(`${kibs.toFixed(2)} KiB`)}`
    )
  }
}

function getBaseUrl (config: ResolvedConfig, options: Options) {
  let base = config.base === './' || config.base === '' ? '/' : config.base

  if (options.base) {
    const optionsBase = options.base === './' || options.base === '' ? '' : options.base
    base = path.posix.join(base, optionsBase)
  }

  return base
}

async function findTemplateFiles (directory: string, extension: string): Promise<string[]> {
  let fileList: string[] = []

  const files = await fs.readdir(directory)
  for (const file of files) {
    const p = path.join(directory, file)
    if ((await fs.stat(p)).isDirectory()) {
      fileList = [...fileList, ...(await findTemplateFiles(p, extension))]
    } else if (file.endsWith(extension)) {
      fileList.push(p)
    }
  }

  return fileList
}

function toLinkTag (template: string, src: string): string {
  return template.replace('{src}', src)
}

function toScriptTag (template: string, src: string, isAsync?: boolean): string {
  return template
    .replace('{src}', src)
    .replace(/[\s]*\{async\}[\s]*/, isAsync ? ' async ' : ' ')
}

function serializeTags (tags: string[], indent: string): string {
  return tags.map(t => indent + t + '\n').join('') + '\n'
}

export default plugin
