# @synajs/tsconfig

TypeScript presets for Syna packages.

```json
{
  "extends": "@synajs/tsconfig/node-library.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  }
}
```

Use `node-app.json` for executable applications. Both presets enable strict checking, NodeNext ESM resolution and JSON modules so `#syna/package` imports type-check in editors.
