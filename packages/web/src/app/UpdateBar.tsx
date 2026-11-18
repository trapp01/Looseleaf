/**
 * The bar the desktop app shows once a newer version is downloaded. Restart
 * installs it now; closing the bar leaves it to install when the app quits,
 * and the bar stays away until a later version is ready.
 */
import { useEffect, useState } from 'react';
import { DismissRegular } from '@fluentui/react-icons';
import { shell } from '../shell-bridge.js';
import { IconButton } from './controls.js';

export function UpdateBar() {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => shell()?.onUpdateReady(setVersion), []);
  if (version === null || version === dismissed) return null;
  return (
    <div className="banner update-bar" role="status">
      <span>Version {version} is ready.</span>
      <button
        type="button"
        className="button small primary"
        onClick={() => void shell()?.restartToUpdate().catch((error: unknown) => console.error(error))}
      >
        Restart to update
      </button>
      <IconButton label="Later" onClick={() => setDismissed(version)}>
        <DismissRegular />
      </IconButton>
    </div>
  );
}
