#!/usr/bin/env node
import process from 'node:process'
import { main } from '../src/cli/main.ts'

process.exitCode = await main(process.argv.slice(2))
