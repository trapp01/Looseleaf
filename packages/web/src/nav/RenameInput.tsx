import { useEffect, useRef, useState } from 'react';

/** An in-place name editor: Enter or leaving commits, Escape cancels. An empty name is not committed. */
export function RenameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name !== null && name.trim() !== '' ? name.trim() : null);
  };
  return (
    <input
      ref={ref}
      className="rename-input"
      value={text}
      aria-label="Name"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(text);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(text)}
    />
  );
}
