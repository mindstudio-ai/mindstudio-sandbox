# @mindstudio-ai/interface

Frontend SDK for [MindStudio](https://mindstudio.ai) v2 app web interfaces.

Typed RPC to backend routes, file picker, uploads, and user context — all from the browser. Zero dependencies, <3KB minified.

## Install

```bash
npm install @mindstudio-ai/interface
```

## Usage

```tsx
import { createClient, platform, auth } from '@mindstudio-ai/interface';

const api = createClient();

function App() {
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    api.getDashboard().then(setDashboard);
  }, []);

  const handleUpload = async () => {
    const url = await platform.requestFile({ type: 'image' });
    // use the CDN url...
  };

  return (
    <div>
      <p>Welcome, {auth.name}</p>
      <img src={auth.profilePictureUrl} />
      <button onClick={handleUpload}>Upload</button>
    </div>
  );
}
```

## API

### `createClient<T>()`

Returns a typed RPC client. Each method maps to a backend route:

```ts
const api = createClient();

const result = await api.submitVendorRequest({ name: 'Acme' });
const dashboard = await api.getDashboard();
```

For type safety, pass an interface matching your backend routes:

```ts
import type { SubmitVendorInput } from '../../backend/src/submitVendorRequest';

interface AppRoutes {
  submitVendorRequest(input: SubmitVendorInput): Promise<{ vendorId: string }>;
  getDashboard(): Promise<DashboardData>;
}

const api = createClient<AppRoutes>();
```

### `platform.requestFile(options?)`

Opens the MindStudio asset library / file picker. Returns a CDN URL.

```ts
const url = await platform.requestFile();
const imageUrl = await platform.requestFile({ type: 'image' });
```

Options: `{ type?: 'image' | 'video' | 'audio' | 'document' }`

### `platform.uploadFile(file)`

Upload a file directly to the CDN without opening a picker.

```ts
const url = await platform.uploadFile(file);
```

### `auth`

Current user's identity (read-only, synchronous):

```ts
auth.userId             // "uuid"
auth.name               // "Sean"
auth.email              // "sean@example.com"
auth.profilePictureUrl  // "https://..." or null
```

For display purposes only. Role checking and permissions are handled by backend routes using `@mindstudio-ai/agent`.

## Error handling

```ts
import { MindStudioInterfaceError } from '@mindstudio-ai/interface';

try {
  await api.submitVendorRequest({ name: '' });
} catch (err) {
  if (err instanceof MindStudioInterfaceError) {
    console.error(err.message); // human-readable
    console.error(err.code);    // 'route_error', 'forbidden', etc.
    console.error(err.status);  // HTTP status
  }
}
```

## How it works

The MindStudio platform injects `window.__MINDSTUDIO__` into the iframe before your code runs. This contains the session token, app/release IDs, user info, and route registry. The SDK reads this automatically — no configuration needed.

Route calls go directly to the API via `fetch`. Platform actions (file picker) use `postMessage` to communicate with the host window.

## License

MIT
