import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  createTerminalFitController,
  type TerminalBox,
  type TerminalDimensions,
  type TerminalFitAdapter,
} from '../src/client/terminal-fit-controller.ts'

function makeHarness(initialBox: TerminalBox = { width: 800, height: 480 }) {
  let box = initialBox
  let connected = true
  let dimensions: TerminalDimensions = { cols: 100, rows: 30 }
  let nextFrame = 0
  const frames = new Map<number, () => void>()
  const calls = { open: 0, fit: 0, sent: [] as TerminalDimensions[] }
  const adapter: TerminalFitAdapter = {
    measure: () => box,
    isConnected: () => connected,
    open: () => { calls.open += 1 },
    fit: () => { calls.fit += 1 },
    dimensions: () => dimensions,
    sendResize: value => { calls.sent.push({ ...value }) },
    requestFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id },
    cancelFrame: id => { frames.delete(id) },
  }
  return {
    adapter,
    calls,
    tick: () => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback()
    },
    pending: () => frames.size,
    setBox: (value: TerminalBox) => { box = value },
    setDimensions: (value: TerminalDimensions) => { dimensions = value },
    disconnect: () => { connected = false },
  }
}

function settle(harness: ReturnType<typeof makeHarness>): void {
  harness.tick()
  harness.tick()
}

describe('terminal fit controller', () => {
  it('waits for a stable positive size before initially opening', () => {
    const harness = makeHarness({ width: 0, height: 0 })
    createTerminalFitController(harness.adapter, true)
    harness.tick()
    harness.tick()
    expect(harness.calls).toEqual({ open: 0, fit: 0, sent: [] })
    harness.setBox({ width: 800, height: 480 })
    harness.tick()
    expect(harness.calls.open).toBe(0)
    harness.tick()
    expect(harness.calls).toEqual({ open: 1, fit: 1, sent: [{ cols: 100, rows: 30 }] })
  })

  it('keeps an initially hidden terminal unopened and unresized', () => {
    const harness = makeHarness({ width: 0, height: 0 })
    const controller = createTerminalFitController(harness.adapter, false)
    controller.requestFit()
    controller.requestFit()
    harness.tick()
    expect(harness.calls).toEqual({ open: 0, fit: 0, sent: [] })
    expect(harness.pending()).toBe(0)
  })

  it('preserves the last grid while hidden', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])

    controller.setVisible(false)
    harness.setBox({ width: 0, height: 0 })
    harness.setDimensions({ cols: 2, rows: 1 })
    controller.requestFit()
    harness.tick()

    expect(harness.calls.fit).toBe(1)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])
  })

  it('waits for two quiet equal frames before fitting after becoming visible', () => {
    const harness = makeHarness({ width: 0, height: 0 })
    const controller = createTerminalFitController(harness.adapter, false)
    controller.setVisible(true)

    harness.setBox({ width: 40, height: 20 })
    harness.tick()
    harness.setBox({ width: 400, height: 240 })
    controller.requestFit()
    harness.tick()
    expect(harness.calls.fit).toBe(0)

    harness.setBox({ width: 800, height: 480 })
    controller.requestFit()
    harness.tick()
    expect(harness.calls.fit).toBe(0)
    harness.tick()

    expect(harness.calls.open).toBe(1)
    expect(harness.calls.fit).toBe(1)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])
  })

  it('opens the host but waits to fit while canFit is false', () => {
    const harness = makeHarness()
    let allowFit = false
    harness.adapter.canFit = () => allowFit
    createTerminalFitController(harness.adapter, true)
    settle(harness)
    expect(harness.calls.open).toBe(1)
    expect(harness.calls.fit).toBe(0)
    expect(harness.calls.sent).toEqual([])
    allowFit = true
    harness.tick()
    expect(harness.calls.fit).toBe(1)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])
  })

  it('restarts settling when the commit-time measurement becomes invalid', () => {
    const harness = makeHarness()
    const measure = harness.adapter.measure
    let measurements = 0
    harness.adapter.measure = () => {
      measurements += 1
      return measurements === 3 ? { width: 0, height: 0 } : measure()
    }
    createTerminalFitController(harness.adapter, true)

    harness.tick()
    harness.tick()
    expect(harness.calls).toEqual({ open: 0, fit: 0, sent: [] })
    expect(harness.pending()).toBe(1)

    harness.tick()
    expect(harness.calls).toEqual({ open: 0, fit: 0, sent: [] })
    harness.tick()
    expect(harness.calls).toEqual({ open: 1, fit: 1, sent: [{ cols: 100, rows: 30 }] })
  })

  it('cancels a settling fit when hidden again', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, false)
    controller.setVisible(true)
    harness.tick()
    controller.setVisible(false)
    harness.tick()
    expect(harness.calls.fit).toBe(0)
    expect(harness.pending()).toBe(0)
  })

  it('waits for two quiet equal frames before sending a visible drag resize', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    harness.setBox({ width: 400, height: 480 })
    harness.setDimensions({ cols: 50, rows: 30 })
    controller.requestFit()
    harness.tick()
    harness.setBox({ width: 200, height: 480 })
    harness.setDimensions({ cols: 25, rows: 30 })
    controller.requestFit()
    harness.tick()
    expect(harness.calls.fit).toBe(1)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])
    harness.tick()
    expect(harness.calls.fit).toBe(2)
    expect(harness.calls.sent).toEqual([
      { cols: 100, rows: 30 },
      { cols: 25, rows: 30 },
    ])
  })

  it('does not send a duplicate grid after a visible fit', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    harness.setBox({ width: 804, height: 480 })
    controller.requestFit()
    settle(harness)
    expect(harness.calls.fit).toBe(2)
    expect(harness.calls.sent).toEqual([{ cols: 100, rows: 30 }])
  })

  it('defers hidden font fits and applies visible font fits by frame', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    controller.setVisible(false)
    controller.requestFit()
    expect(harness.pending()).toBe(0)
    controller.setVisible(true)
    settle(harness)
    expect(harness.calls.fit).toBe(2)

    controller.requestFit()
    controller.requestFit()
    settle(harness)
    expect(harness.calls.fit).toBe(3)
  })

  it('isolates terminal disposal races from scheduled fits', () => {
    const harness = makeHarness()
    harness.adapter.fit = () => { throw new Error('disposed') }
    createTerminalFitController(harness.adapter, true)
    harness.tick()
    expect(() => harness.tick()).not.toThrow()
    expect(harness.calls.sent).toEqual([])
  })

  it('never opens a detached host and dispose is idempotent', () => {
    const harness = makeHarness()
    const controller = createTerminalFitController(harness.adapter, true)
    harness.disconnect()
    harness.tick()
    harness.tick()
    expect(harness.calls.open).toBe(0)

    controller.dispose()
    controller.dispose()
    controller.setVisible(true)
    controller.requestFit()
    harness.tick()
    expect(harness.calls).toEqual({ open: 0, fit: 0, sent: [] })
    expect(harness.pending()).toBe(0)
  })

  it('keeps carriage-return progress on one logical line while hidden', async () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    const harness = makeHarness()
    harness.adapter.fit = () => {
      harness.calls.fit += 1
      const box = harness.adapter.measure()
      term.resize(box.width < 10 ? 2 : 80, box.height < 10 ? 1 : 24)
    }
    harness.adapter.dimensions = () => ({ cols: term.cols, rows: term.rows })
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    controller.setVisible(false)
    harness.setBox({ width: 0, height: 0 })
    controller.requestFit()
    await new Promise<void>(resolve => term.write(
      'start\r\nremote: Counting objects: 10%\rremote: Counting objects: 50%\rremote: Counting objects: 100%\r\ndone',
      resolve,
    ))

    expect(term.cols).toBe(80)
    const lines = Array.from({ length: term.buffer.active.length }, (_, index) =>
      term.buffer.active.getLine(index)?.translateToString(true) ?? '')
    expect(lines.filter(line => line.includes('remote:')).length).toBe(1)
    expect(lines.some(line => line.includes('remote: Counting objects: 100%'))).toBe(true)
    expect(Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index)?.isWrapped)
      .filter(Boolean).length).toBe(0)
    term.dispose()
  })

  it('replays carriage-return progress at the remembered grid without concatenating', async () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    await new Promise<void>(resolve => term.write(
      'remote: Resolving deltas:  23% (27/116)\rremote: Resolving deltas:  50% (58/116)\rremote: Resolving deltas: 100% (116/116)\r\n',
      resolve,
    ))
    const before = Array.from({ length: term.buffer.active.length }, (_, index) =>
      term.buffer.active.getLine(index)?.translateToString(true) ?? '')
    expect(before.filter(line => line.includes('remote:')).length).toBe(1)
    expect(before.some(line => line.includes('116Resolving'))).toBe(false)
    term.resize(28, 24)
    const after = Array.from({ length: term.buffer.active.length }, (_, index) =>
      term.buffer.active.getLine(index)?.translateToString(true) ?? '')
    expect(after.some(line => line.includes('116Resolving'))).toBe(false)
    term.dispose()
  })

  it('keeps carriage-return progress on one logical line during a visible drag', async () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    const harness = makeHarness()
    harness.adapter.fit = () => {
      harness.calls.fit += 1
      const box = harness.adapter.measure()
      term.resize(box.width < 400 ? 28 : 80, 24)
    }
    harness.adapter.dimensions = () => ({ cols: term.cols, rows: term.rows })
    const controller = createTerminalFitController(harness.adapter, true)
    settle(harness)
    await new Promise<void>(resolve => term.write('remote: Compressing objects:  75% (812/1082)\r', resolve))

    harness.setBox({ width: 280, height: 480 })
    controller.requestFit()
    harness.tick()
    await new Promise<void>(resolve => term.write('remote: Compressing objects:  90% (974/1082)\r', resolve))
    harness.setBox({ width: 160, height: 480 })
    controller.requestFit()
    harness.tick()
    await new Promise<void>(resolve => term.write('remote: Compressing objects:  100% (1082/1082)\r\n', resolve))

    expect(term.cols).toBe(80)
    const lines = Array.from({ length: term.buffer.active.length }, (_, index) =>
      term.buffer.active.getLine(index)?.translateToString(true) ?? '')
    expect(lines.filter(line => line.includes('remote:')).length).toBe(1)
    expect(lines.some(line => line.includes('remote: Compressing objects:  100%'))).toBe(true)
    expect(Array.from({ length: term.buffer.active.length }, (_, index) => term.buffer.active.getLine(index)?.isWrapped)
      .filter(Boolean).length).toBe(0)
    term.dispose()
  })
})
