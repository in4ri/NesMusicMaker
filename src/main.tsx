import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startAudioSync } from './audio/sync';
import './styles.css';

startAudioSync();

if (import.meta.env.DEV) {
  // Hooks for automated UI testing in a browser (no MIDI hardware or file picker needed).
  void Promise.all([import('./model/store'), import('./audio/midiInput'), import('./audio/liveInput'), import('./ui/MidiImportDialog')]).then(
    ([store, midi, live, dialog]) => {
      (window as unknown as Record<string, unknown>).__nes = {
        useStore: store.useStore,
        useInput: live.useInput,
        handleMidiMessage: midi.handleMidiMessage,
        openMidiImport: dialog.openMidiImport,
      };
    },
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
