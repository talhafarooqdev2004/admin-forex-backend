import { resolve as importMetaResolve } from 'import-meta-resolve';
import { pathToFileURL } from 'url';
export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
        const resolved = pathToFileURL(new URL('./src/' + specifier.slice(2), import.meta.url).pathname).href;
        return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
