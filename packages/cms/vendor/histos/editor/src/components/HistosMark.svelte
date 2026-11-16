<script lang="ts">
  // The Histeon mark (plugin/assets/brand/histos-mark.svg, docs/brand.md): two posts and the weft woven over and
  // under the warp make an H; the weights are those of the ancient Greek upright loom (ἱστός).
  let { size = 30 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <rect width="64" height="64" rx="15" fill="#171A33" />
  <g stroke="#F3ECE1" stroke-linecap="round">
    <line x1="16" y1="12" x2="16" y2="52" stroke-width="6" />
    <line x1="48" y1="12" x2="48" y2="52" stroke-width="6" />
    <line x1="27" y1="12" x2="27" y2="44" stroke-width="3" opacity=".8" />
    <line x1="37" y1="12" x2="37" y2="44" stroke-width="3" opacity=".8" />
  </g>
  <circle cx="27" cy="48" r="3.4" fill="#FF6F5E" />
  <circle cx="37" cy="48" r="3.4" fill="#FF6F5E" />
  <line x1="16" y1="32" x2="48" y2="32" stroke="#FF6F5E" stroke-width="6" stroke-linecap="round" />
  <line x1="37" y1="28.5" x2="37" y2="35.5" stroke="#F3ECE1" stroke-width="3" />
</svg>
