export interface TerminalDimensions {
  cols: number
  rows: number
}

export interface TerminalBox {
  width: number
  height: number
}

export interface TerminalFitAdapter {
  measure(): TerminalBox
  isConnected(): boolean
  open(): void
  fit(): void
  dimensions(): TerminalDimensions
  sendResize(dimensions: TerminalDimensions): void
  requestFrame(callback: () => void): number
  cancelFrame(frameId: number): void
  canFit?(): boolean
}

export interface TerminalFitController {
  setVisible(visible: boolean): void
  requestFit(): void
  dispose(): void
}

type TerminalGeometryState = 'hidden' | 'settling' | 'ready' | 'disposed'

export function createTerminalFitController(
  adapter: TerminalFitAdapter,
  initialVisible: boolean,
): TerminalFitController {
  let state: TerminalGeometryState = initialVisible ? 'settling' : 'hidden'
  let opened = false
  let frame: number | null = null
  let generation = 0
  let lastSent: TerminalDimensions | null = null

  const cancelFrame = (): void => {
    if (frame === null) return
    adapter.cancelFrame(frame)
    frame = null
  }

  const validBox = (box: TerminalBox): boolean => box.width > 0 && box.height > 0

  const fitAndResize = (): 'done' | 'wait' | 'invalid' => {
    if (state === 'hidden' || state === 'disposed') return 'wait'
    if (!adapter.isConnected()) return 'wait'
    const box = adapter.measure()
    if (!validBox(box)) return 'invalid'
    if (!opened) {
      adapter.open()
      opened = true
    }
    if (adapter.canFit?.() === false) return 'wait'
    adapter.fit()
    const dimensions = adapter.dimensions()
    if (dimensions.cols <= 0 || dimensions.rows <= 0) return 'invalid'
    if (lastSent?.cols === dimensions.cols && lastSent.rows === dimensions.rows) return 'done'
    lastSent = { ...dimensions }
    adapter.sendResize(dimensions)
    return 'done'
  }

  const settle = (): void => {
    cancelFrame()
    const currentGeneration = ++generation
    let previous: TerminalBox | null = null
    const check = (): void => {
      frame = null
      if (state !== 'settling' || currentGeneration !== generation) return
      if (!adapter.isConnected()) return
      const box = adapter.measure()
      if (!validBox(box)) {
        previous = null
        frame = adapter.requestFrame(check)
        return
      }
      if (previous === null || previous.width !== box.width || previous.height !== box.height) {
        previous = box
        frame = adapter.requestFrame(check)
        return
      }
      try {
        const result = fitAndResize()
        if (result === 'wait') {
          frame = adapter.requestFrame(check)
          return
        }
        if (result === 'invalid') {
          previous = null
          frame = adapter.requestFrame(check)
          return
        }
      } catch {
        return
      }
      if (state === 'settling') state = 'ready'
    }
    frame = adapter.requestFrame(check)
  }

  if (state === 'settling') settle()

  return {
    setVisible(visible) {
      if (state === 'disposed') return
      if (!visible) {
        generation += 1
        cancelFrame()
        state = 'hidden'
        return
      }
      if (state === 'hidden') {
        state = 'settling'
        settle()
      }
    },
    requestFit() {
      if (state === 'disposed' || state === 'hidden') return
      state = 'settling'
      settle()
    },
    dispose() {
      if (state === 'disposed') return
      state = 'disposed'
      generation += 1
      cancelFrame()
    },
  }
}
