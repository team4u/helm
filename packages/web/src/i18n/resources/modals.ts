/**
 * Modal-support model copy (node picker, plugin config form labels shared with
 * web-owned modals, provider auth, profile editor skills). Owner: the
 * profiles-skills partition.
 */
import type { MessageTable } from '../messages.js'

export const modalsMessages = {
  // Seeded by the profiles-skills partition; empty until its migration lands.
} satisfies MessageTable
