<script lang="ts">
  /**
   * Icon — the single icon source for the app (spec §1.5: no Lucide).
   * Hand-authored 24px stroke icons in the Phosphor regular spirit.
   * Usage: <Icon name="search" size={16} label="Search" />
   * `label` renders <title> for native tooltips + screen readers.
   */
  let {
    name,
    size = 16,
    label,
    class: className,
  }: {
    name: string;
    size?: number;
    label?: string;
    class?: string;
  } = $props();

  const paths: Record<string, string> = {
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-6h4v6"/>',
    calendar:
      '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M8 3v4M16 3v4"/>',
    pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>',
    graph:
      '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l7.5.5M7 8.5l3.5 7M17 10.5l-3.5 5.5"/>',
    book: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z"/><path d="M5 17a3 3 0 013-3h11"/>',
    "book-open":
      '<path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2z"/><path d="M12 6v14"/>',
    film:
      '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4"/>',
    folder: '<path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z"/>',
    files:
      '<path d="M8 8h11a1 1 0 011 1v11a1 1 0 01-1 1H8a1 1 0 01-1-1V9a1 1 0 011-1z"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v11a1 1 0 001 1h1"/>',
    inbox: '<path d="M4 13l2.5-8h11L20 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2l.4 2.7h4l.4-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L20 20"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    refresh: '<path d="M20 12a8 8 0 10-2.3 5.6"/><path d="M20 12V6m0 6h-6"/>',
    pin: '<path d="M9 4h6l1 7 3 3v2H5v-2l3-3 1-7z"/><path d="M12 16v5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3"/>',
    speaker: '<path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-8M20 20H4"/>',
    dots: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    history: '<path d="M4 12a8 8 0 118-8"/><path d="M4 4v5h5"/><path d="M12 8v4l3 2"/>',
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    upload: '<path d="M12 20v-11"/><path d="M17 13l-5-5-5 5"/><path d="M4 4h16"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
    edit: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 00-3-3L5 17l-1 3z"/>',
    link: '<path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1.5-1.5"/>',
    image:
      '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-5 3 3 3-3 5 5"/>',
    table:
      '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 10v10M15 10v10"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
    unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 017.5-2"/>',
    bell: '<path d="M6 16v-5a6 6 0 0112 0v5l1.5 2.5h-15L6 16z"/><path d="M10 21a2.2 2.2 0 004 0"/>',
    keyboard:
      '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 14h.01M17 14h.01M10 14h4"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.5h.01"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    sparkle:
      '<path d="M12 3l1.8 5.7L19.5 10l-5.7 1.8L12 17.5l-1.8-5.7L4.5 10l5.7-1.3L12 3z"/><path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/>',
    panel: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M15 4v16"/>',
    send: '<path d="M20 4L10 14"/><path d="M20 4l-7 18-3-8-6-3 16-7z"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
    board: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.3 4v7M14.6 4v12"/>',
    warn: '<path d="M12 3L2.5 20h19L12 3z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/>',
    "arrow-right": '<path d="M5 12h14M12 5l7 7-7 7"/>',
    "arrow-left": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    minus: '<path d="M5 12h14"/>',
    tag: '<path d="M6 3h10l4 4v10H6V3z"/><circle cx="12" cy="12" r="2"/>',
  };

  const svg = $derived(paths[name] ?? paths.info);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  class={className}
>
  {#if label}<title>{label}</title>{/if}
  {@html svg}
</svg>
