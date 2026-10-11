export interface DouyinPipeLaunchContext {
  mode: 'pipe'
  pipeName: string
  maxChannels: number
  mateVersion: string
  layoutMode: number | null
}

export type DouyinLaunchContext = DouyinPipeLaunchContext

let runtimeContext: DouyinLaunchContext | null = parseDouyinLaunchContext(process.argv)

function readArgument(commandLine: readonly string[], name: string): string {
  const prefixes = [`--${name}=`, `-${name}=`]
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index]
    const prefix = prefixes.find((candidate) => argument.startsWith(candidate))
    if (prefix) return argument.slice(prefix.length).trim()
    if (argument === `--${name}` || argument === `-${name}`) {
      return commandLine[index + 1]?.trim() ?? ''
    }
  }
  return ''
}

export function parseDouyinLaunchContext(
  commandLine: readonly string[]
): DouyinLaunchContext | null {
  const pipeName = readArgument(commandLine, 'pipeName')
  if (pipeName) {
    const rawMaxChannels = Number.parseInt(readArgument(commandLine, 'maxChannels'), 10)
    const rawLayoutMode = Number.parseInt(readArgument(commandLine, 'layoutMode'), 10)
    return {
      mode: 'pipe',
      pipeName,
      maxChannels: Number.isInteger(rawMaxChannels) && rawMaxChannels > 0 ? rawMaxChannels : 6,
      mateVersion: readArgument(commandLine, 'mateVersion'),
      layoutMode: Number.isInteger(rawLayoutMode) ? rawLayoutMode : null
    }
  }

  return null
}

export function updateDouyinLaunchContext(commandLine: readonly string[]): boolean {
  const next = parseDouyinLaunchContext(commandLine)
  if (!next) return false
  runtimeContext = next
  return true
}

export function getDouyinLaunchContext(): DouyinLaunchContext | null {
  return runtimeContext
}
