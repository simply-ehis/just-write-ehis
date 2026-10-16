path = 'src/lib/components/DockSplit.svelte'
with open(path, 'r', newline='') as f:
    content = f.read()

old = '  let horizontal = $derived(direction === "horizontal");\r\n'
new = '''  let horizontal = $derived(direction === "horizontal");
  /** Auto-expanded via hover (collapsed sidebar mouse-over). */
  let autoExpanded = $derived(autoReveal && horizontal && topCompact && hovered);
  let hovered = $state(false);
'''

assert old in content, "pattern not found"
content = content.replace(old, new, 1)

with open(path, 'w', newline='') as f:
    f.write(content)
print('Done')
