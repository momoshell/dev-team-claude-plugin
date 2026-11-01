export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const d = event.data
    const error = d.details?.error
    // An asynchronous module initializer can reject without any loader frames.
    // Require a frame in the test file as evidence that its body failed.
    let importFailure = event.type === 'test:fail' && !(typeof d.file === 'string' && typeof error?.cause?.stack === 'string' && error.cause.stack.includes(`${d.file}:`))
    const pending = [error?.cause], seen = new Set()
    while (pending.length) {
      const cause = pending.pop()
      if (!cause || typeof cause !== 'object' || typeof cause.stack !== 'string') { importFailure = true; break }
      if (seen.has(cause)) continue
      seen.add(cause)
      if (cause.code === 'ERR_MODULE_NOT_FOUND' || cause.code === 'MODULE_NOT_FOUND' || /node:internal\/modules\/(esm|cjs)\//.test(cause.stack)) { importFailure = true; break }
      if ('cause' in cause) pending.push(cause.cause)
      if (Array.isArray(cause.errors)) pending.push(...cause.errors)
    }
    yield JSON.stringify({ type: event.type, name: d.name, file: d.file, line: d.line, column: d.column, nesting: d.nesting, skip: d.skip != null && d.skip !== false, todo: d.todo != null && d.todo !== false, failureType: importFailure ? 'importFailed' : error?.failureType ?? error?.cause?.failureType ?? null }) + '\n'
  }
}
