import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from 'syna'

export const define = definePackage(packageJson)
