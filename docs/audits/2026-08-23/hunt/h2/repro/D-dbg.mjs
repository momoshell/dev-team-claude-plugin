import { scopeMatcher } from '/private/tmp/claude-501/-Users-x-Development-dt-s2-factory/c49caf70-34b7-4e21-9582-82e8a04597f0/scratchpad/h2/repo/crew/drive.mjs'
const a = 'lib/café.mjs'
console.log(JSON.stringify([...a].map(c=>c.codePointAt(0).toString(16))))
console.log('self match:', scopeMatcher([a])(a))
console.log('nfd vs nfc:', scopeMatcher([a.normalize('NFC')])(a.normalize('NFD')))
