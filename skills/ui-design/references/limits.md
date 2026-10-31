# Known limits

The palette in `visualizer/web/src/lib/theme.css` supplies paper and ink aliases, but source tokens alone do not establish rendered contrast. Check foreground and actual background in both themes, including hover, disabled, mixed and transparent surfaces. Do not borrow a page ground when the component paints another surface.

`visualizer/web/src/lib/Dropdown.svelte` uses a mixed hover background; its rendered contrast requires resolving the mix and its actual context. `visualizer/web/src/lib/LeanRunDetail.svelte` changes button and summary backgrounds on hover. These source exhibits are not browser measurements.

No comprehensive rendered contrast audit is claimed here. Source tests and token names do not prove that all components use aliases, that all aliases exist at runtime, or that all interaction states meet contrast requirements. Document unmeasured cases rather than inventing ratios.
