// --task normalisation: does a hostile slug escape ~/.crew/<repo>/<slug>?
const { slug } = await import('/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/slug.mjs')
const NUL = String.fromCharCode(0), ESC = String.fromCharCode(27)
for (const s of ['../../etc/passwd', '/abs/path', 'a' + NUL + 'b', ESC + '[31mx', 'a\nb', '....', '---', 'CAPS', 'a b', 'ünïcode', '‮rtl', '.'])
  { try { console.log(JSON.stringify(s).padEnd(22), '->', JSON.stringify(slug(s))) } catch (e) { console.log(JSON.stringify(s).padEnd(22), '-> REFUSE', e.message.slice(0, 60)) } }
