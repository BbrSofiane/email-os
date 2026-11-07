<script setup lang="ts">
/**
 * One full-form date (DESIGN.md "Dates"): `Thu 9 Jan 2025, 6:29 PM` in the
 * viewer's zone, `Unknown date` when missing or unparsable, always a `<time>`
 * with a normalized ISO `datetime` when the timestamp parses. Drawer, notice
 * and reader copy use this instead of printing raw provider timestamps.
 */
import { fullDateLabel, machineDateTime } from '../lib/browsing-dates';

defineProps<{ at: string }>();
</script>

<template>
  <time :datetime="machineDateTime(at)">{{ fullDateLabel(at) }}</time>
</template>
