import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startAudioSync } from './audio/sync';
import { loadLibrary } from './library';
import './styles.css';

startAudioSync();
void loadLibrary();

if (import.meta.env.DEV) {
  // Hooks for automated UI testing in a browser (no MIDI hardware or file picker needed).
  void Promise.all([
    import('./model/store'),
    import('./audio/midiInput'),
    import('./audio/liveInput'),
    import('./ui/MidiImportDialog'),
    import('./ui/NsfImportDialog'),
  ]).then(([store, midi, live, dialog, nsf]) => {
    (window as unknown as Record<string, unknown>).__nes = {
      useStore: store.useStore,
      useInput: live.useInput,
      handleMidiMessage: midi.handleMidiMessage,
      openMidiImport: dialog.openMidiImport,
      openNsfImport: nsf.openNsfImport,
    };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
