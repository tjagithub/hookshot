#!/usr/bin/env node
import process from 'node:process'
import { main } from '../src/cli/main.ts'
import { resolveSelf } from '../src/cli/self.ts'

resolveSelf()
process.exitCode = await main(process.argv.slice(2))
