# Backend Integration Plugin for Vite

A Vite plugin that simplifies integration with backend template engines.

The plugin works by scanning a user-specified source directory for template files. It analyzes the Vite build output to determine which assets are needed for each entry point. Based on this analysis, it dynamically inserts the appropriate `<script>`, `<link rel="preload">`, and `<link rel="stylesheet">` tags into the templates and place them in the configured output directory.

## Installation
```shell
npm install -D vite-plugin-backend-integration
```

## Usage
1\. In your Vite config, configure the following:
* Add the plugin and specify the template source directory and other [options](#options) as needed.
* Set `server.origin` so that generated asset URLs will be resolved using the Vite's dev server URL instead of a relative path.
* configure the entry points

```js
import { defineConfig } from 'vite';
import { backendIntegration } from 'vite-plugin-backend-integration';

export default defineConfig({
  plugins: [
    backendIntegration({
      srcDir: 'templates'
    })
  ],
  server: {
    port: 5173,
    strictPort: true,
    origin: 'http://localhost:5173'
  },
  build: {
    rollupOptions: {
      input: {
        main: 'static/main.js',
        other: 'static/sub-dir/other.js'
      }
    },
  },
});
```

> **_NOTE:_** There is no need to import the [module preload polyfill](https://guybedford.com/es-module-preloading-integrity#modulepreload-polyfill) into your entry manually. The plugin will take care of that for you.

2\. For development, inject the following in your template (substitute http://localhost:5173 with the local URL Vite is running at):

```html
<script type="module" src="http://localhost:5173/@vite/client"></script>
<script type="module" src="http://localhost:5173/static/main.js"></script>
```

3\. That's it! Now when you run the Vite build, the plugin will automatically modify your templates by injecting the necessary asset tags and output them to the specified output directory.

Further information on how to set up Vite with traditional backends can be found in the [Vite backend integration guide](https://vitejs.dev/guide/backend-integration.html).

## Options

### `srcDir`

- **Type:** `string`

The template source directory. Valid values include:

* Absolute path, e.g. `/templates`
* Relative path e.g. `templates` (relative to the [project root directory](https://vite.dev/config/shared-options#root)).

### `outDir`

- **Type:** `string | undefined`
- **Default:** `srcDir`

The template output directory. Valid values include:

* Absolute path, e.g. `/templates`
* Relative path e.g. `../templates` (relative to [build.outDir](https://vite.dev/config/build-options#build-outdir)).

### `extension`

- **Type:** `string`
- **Default:** `.html`

The template file extension.

### `base`

- **Type:** `string | undefined`

A relative path that is appended to Vite's [base path](https://vite.dev/config/shared-options#base) during asset URL generation. This is useful when the backend serves static assets from a specific base path e.g. `static/`.

### `assetTags`

- **Type:** `AssetTags`
- **Default:**
  ```js
  {
    script: '<script type="module" crossorigin src="{src}"></script>',
    preload: '<link rel="modulepreload" crossorigin href="{src}">',
    stylesheet: '<link rel="stylesheet" href="{src}">'
  }
  ```

This option allows customizing the asset tags injected into the templates on build. You can use `{src}` and `{async}` placeholders to control how the tags are generated. The `{src}` placeholder will be replaced with the relative asset URL, and the `{async}` placeholder will be replaced with `async` for script tags if applicable.

For example, if you use Thymeleaf as your template engine, you can adjust the configuration to use [Thymeleaf's syntax for URL resolution](https://www.thymeleaf.org/doc/articles/standardurlsyntax.html#context-relative-urls).

```js
assetTags: {
  script: '<script type="module" crossorigin th:src="@{src}"></script>',
  preload: '<link rel="modulepreload" crossorigin th:href="@{src}">',
  stylesheet: '<link rel="stylesheet" th:href="@{src}">'
}
```

