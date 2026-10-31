# Keyboard operability and visible focus

**K1:** Prefer native controls; custom behaviour must be keyboard operable. `visualizer/web/src/lib/TaskList.svelte` uses native buttons for task opening and its status selector is a `role=group` of pressed buttons, not a tablist. `visualizer/web/src/lib/Dropdown.svelte` has explicit arrow, Home, End, Enter and Escape handling on its trigger. Source: vercel-web-interface-guidelines.md — interactive elements; ui-ux-pro-max-ux-guidelines.csv — row 41.

**K2:** Give interactive controls visible focus. Dropdown has a local `:focus-visible` rule; `visualizer/web/src/lib/theme.css` also supplies shared focus outlines for native controls. Component-local selectors alone do not measure shared coverage or prove every interaction is accessible. Source: vercel-web-interface-guidelines.md — focus states; ui-ux-pro-max-ux-guidelines.csv — row 28.

When introducing actual tablist semantics, implement the corresponding keyboard behaviour rather than assuming a group of buttons is a tablist. Check focus movement and restoration when changing views.
