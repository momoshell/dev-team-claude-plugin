await lab.scratchCheckout()
const anchors = await lab.grep('anchors.json', {
  fixedString: true,
  pathspec: ['skills/qa-test-writing/references/citations.md'],
})
const shifted = await lab.grep('shifted', {
  fixedString: true,
  pathspec: ['skills/qa-test-writing/anchor-pin.mjs'],
})
export default { anchors, shifted }
