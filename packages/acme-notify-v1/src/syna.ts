import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from 'synajs'

export const define = definePackage(packageJson)
