// Plain-language explanations shown by the "?" buttons.

export function ChannelRackHelp() {
  return (
    <>
      <p>The NES has five sound channels. Each row here is one of them:</p>
      <ul>
        <li><b>Pulse 1 &amp; 2</b>: buzzy square waves for melody and harmony.</li>
        <li><b>Triangle</b>: a soft, deep tone for bass. It has no volume control on real hardware (just on or off).</li>
        <li><b>Noise</b>: hiss for drums and effects.</li>
        <li><b>DMC</b>: plays short recorded samples.</li>
      </ul>
      <p>Each channel plays <b>one note at a time</b>.</p>
      <h5>Left to right</h5>
      <ul>
        <li><b>Light</b>: flashes when the channel makes sound.</li>
        <li><b>● / S</b>: mute, and solo (hear only this channel). These are for listening only. Exports always include every channel.</li>
        <li><b>Channel name</b>: click to open its notes in the piano roll below.</li>
        <li><b>Sound</b>: the instrument the whole channel plays with. Change it and every note on the channel changes.</li>
        <li><b>Step note</b>: the note every square in the row plays. On Noise it picks the drum sound (0 = low rumble, F = high hiss), and on DMC it picks the sample. Changing it changes the squares already in that row.</li>
        <li><b>Squares</b>: a drum machine. Click a square to add a short note on that beat, click again to remove it, or drag to paint. Darker squares are longer notes drawn in the piano roll.</li>
      </ul>
      <p>For melodies with different notes, use the piano roll. The squares are best for beats and repeating bass.</p>
    </>
  );
}

export function PianoRollHelp() {
  return (
    <>
      <p>
        The piano roll shows the notes of one channel in the current pattern. <b>Up and down</b> is pitch (the keyboard on the left; click a
        key to hear it), and <b>left to right</b> is time. Each bar has 16 small steps.
      </p>
      <ul>
        <li><b>Click</b> an empty spot to add a note. Drag it to move it, or drag its right edge to make it longer.</li>
        <li><b>Right-click</b> a note to delete it.</li>
        <li><b>Volume lane</b> (bottom): drag the stalks to make notes louder or quieter.</li>
        <li><b>Right-hand panel</b>: select notes to change their volume, give them effects (vibrato, bend, glide) or turn them into an <b>arpeggio chord</b>.</li>
      </ul>
      <h5>Real-NES rules</h5>
      <ul>
        <li>One note at a time: if notes overlap, the earlier one is shortened (shown in red while dragging).</li>
        <li>Clicking a note onto the start of another makes a chord, which plays as a fast arpeggio (the classic NES trick).</li>
        <li>The shaded area at the bottom of Pulse 1 &amp; 2 is too low for those channels. Use the Triangle for deep bass.</li>
      </ul>
    </>
  );
}

export function PlaylistHelp() {
  return (
    <>
      <p>
        The playlist arranges your <b>patterns</b> into a whole song. A pattern is a short loop (a few bars) holding notes for all five
        channels. Click <b>SONG</b> at the top to hear the playlist, or <b>PAT</b> to loop just the selected pattern.
      </p>
      <ul>
        <li><b>Click</b> an empty spot to place the selected pattern (choose it on the right). Drag a block to move it, and right-click to remove it.</li>
        <li>The <b>tracks</b> are just rows to lay blocks out on; they aren't channels. Two blocks playing the same channel at once are marked with a red ⚠, because only one note can sound.</li>
        <li><b>Ruler</b>: click to choose where playback starts. Shift-click to set the <b>LOOP</b> point, where the song jumps back to after it ends (game music loops forever).</li>
      </ul>
      <h5>Automation lanes</h5>
      <p>
        The coloured lanes under the tracks change a channel over the whole song. Click to add points, drag them, and right-click to remove.
      </p>
      <ul>
        <li><b>Vol</b>: fade a channel in or out (0–15).</li>
        <li><b>Duty</b>: sweep a pulse channel's tone from thin to hollow.</li>
        <li><b>Det</b>: tune a channel slightly sharp or flat (try Pulse 2 at +8 against Pulse 1 for a chorus effect).</li>
      </ul>
      <p>Choose which lanes show on the right. Automation is heard in SONG mode and in exports.</p>
    </>
  );
}

export function InstrumentHelp() {
  return (
    <>
      <p>
        An <b>instrument</b> is a recipe for how a note behaves while it plays. The NES can't shape sounds by itself, so the instrument
        tells it what to change about the note, 50–60 times a second.
      </p>
      <h5>Top row</h5>
      <ul>
        <li><b>Name</b> and <b>colour</b>: notes using this instrument are drawn in its colour.</li>
        <li><b>Audition on … C3–C6</b>: click a note to hear the instrument on that channel. The same instrument sounds different on each channel; for example, the Triangle ignores volume and tone.</li>
        <li><b>Use on …</b>: makes this instrument that channel's sound (same as the Sound dropdown in the channel list).</li>
      </ul>
      <h5>The four graphs</h5>
      <p>Each bar is one moment in time (1/60th of a second). Draw on them with the mouse.</p>
      <ul>
        <li><b>Volume</b>: how loud the note is at each moment. Tall-then-shrinking bars give a pluck or fade.</li>
        <li><b>Arpeggio</b>: quick note jumps. Repeating 0, 4, 7 gives the classic chiptune chord shimmer.</li>
        <li><b>Pitch</b>: small bends, such as vibrato or a drop at the start.</li>
        <li><b>Duty</b>: the tone of Pulse channels, from thin and buzzy to hollow.</li>
        <li><b>Loop / release strips</b> (under each graph): click to set where the sound repeats while a note is held, and where it jumps when the note ends. That's how fade-outs work.</li>
        <li><b>Presets</b>: ready-made shapes to start from.</li>
      </ul>
      <p>Try it: click C4, choose Presets → Pluck on the Volume graph, then click C4 again.</p>
    </>
  );
}
