/* Lets a plain Node script import the app's TypeScript modules in lib/ — so the
   offline build renders content with the exact same code as the website.

   Resolves extensionless relative imports to .ts and transpiles .ts on load
   with the project's own `typescript` devDependency. No tsx/esbuild needed. */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, next) {
  if (/^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier) && context.parentURL) {
    const url = new URL(`${specifier}.ts`, context.parentURL);
    if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = fs.readFileSync(fileURLToPath(url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  return { format: 'module', source: outputText, shortCircuit: true };
}
