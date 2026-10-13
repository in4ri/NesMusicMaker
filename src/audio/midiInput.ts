// Web MIDI: device discovery and note messages from MIDI keyboards (all MIDI channels).

import { create } from 'zustand';
import { useStore } from '../model/store';
import { inputNoteOff, inputNoteOn, midiNoteToChannelPitch } from './liveInput';

export type MidiStatus = 'off' | 'requesting' | 'on' | 'unsupported' | 'denied';

export interface MidiState {
  status: MidiStatus;
  inputs: { id: string; name: string }[];
  /** 'all' or a specific input id. */
  inputId: string;
  /** Flashes on incoming notes so the user can see the keyboard is connected. */
  activity: number;
}

export const useMidi = create<MidiState>(() => ({ status: 'off', inputs: [], inputId: 'all', activity: 0 }));

let access: MIDIAccess | null = null;

/** Handle one raw MIDI message. Exported for testing. */
export function handleMidiMessage(data: Uint8Array | number[]) {
  const [status, d1, d2] = data;
  const type = status & 0xf0;
  if (type !== 0x90 && type !== 0x80) return;
  const key = `midi:${d1}`;
  if (type === 0x90 && d2 > 0) {
    const pitch = midiNoteToChannelPitch(d1, useStore.getState().selectedChannel);
    if (pitch === null) return;
    useMidi.setState((s) => ({ activity: s.activity + 1 }));
    inputNoteOn(key, pitch, d2);
  } else {
    inputNoteOff(key);
  }
}

function attach() {
  if (!access) return;
  const { inputId } = useMidi.getState();
  const inputs: { id: string; name: string }[] = [];
  access.inputs.forEach((input) => {
    inputs.push({ id: input.id, name: input.name || 'MIDI input' });
    const listen = inputId === 'all' || inputId === input.id;
    input.onmidimessage = listen ? (e: MIDIMessageEvent) => e.data && handleMidiMessage(e.data) : null;
  });
  useMidi.setState({ inputs });
}

export async function enableMidi(inputId = 'all') {
  useMidi.setState({ inputId });
  if (access) {
    attach();
    return;
  }
  if (!navigator.requestMIDIAccess) {
    useMidi.setState({ status: 'unsupported' });
    return;
  }
  useMidi.setState({ status: 'requesting' });
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => attach();
    useMidi.setState({ status: 'on' });
    attach();
  } catch {
    useMidi.setState({ status: 'denied' });
  }
}

export function disableMidi() {
  if (access) access.inputs.forEach((input) => (input.onmidimessage = null));
  useMidi.setState({ status: 'off' });
  access = null;
}
