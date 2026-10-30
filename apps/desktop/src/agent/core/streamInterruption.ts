export const STEERING_INTERRUPT_DIAGNOSTIC = 'steering-stream-interrupt'

export type BindModelStreamInterrupt = (
  interrupt: () => void,
) => void | (() => void)
