import "./App.css";

function App() {
  return (
    <main class="min-h-screen bg-[#f7f2df] text-[#211f1b]">
      <section class="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-12">
        <div class="max-w-2xl">
          <p class="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-[#7f6428]">
            Simeioma
          </p>
          <h1 class="text-4xl font-semibold leading-tight sm:text-5xl">
            Lightweight desktop post-its for fast, short-lived notes.
          </h1>
          <p class="mt-6 max-w-xl text-lg leading-8 text-[#514a3f]">
            A Tauri 2, Rust, Solid, Tailwind, and Bun foundation for a
            cross-platform notes app engineered around sub-second startup,
            floating note windows, and local-first capture.
          </p>
        </div>

        <div class="mt-10 grid gap-3 sm:grid-cols-3">
          <div class="rounded-lg border border-[#e0d0a8] bg-[#fff7cf] p-4 shadow-sm">
            <h2 class="text-sm font-semibold uppercase tracking-[0.14em] text-[#6d561e]">
              Always Ready
            </h2>
            <p class="mt-3 text-sm leading-6 text-[#514a3f]">
              Persistent color strip launcher, instant note creation, and
              focused writing without document ceremony.
            </p>
          </div>
          <div class="rounded-lg border border-[#d9b6a8] bg-[#ffe1d4] p-4 shadow-sm">
            <h2 class="text-sm font-semibold uppercase tracking-[0.14em] text-[#7f3b28]">
              Local First
            </h2>
            <p class="mt-3 text-sm leading-6 text-[#514a3f]">
              Rust-backed persistence, crash-safe autosave, export paths, and
              clipboard-first workflows.
            </p>
          </div>
          <div class="rounded-lg border border-[#b7ceb1] bg-[#ddf0d8] p-4 shadow-sm">
            <h2 class="text-sm font-semibold uppercase tracking-[0.14em] text-[#35612f]">
              Performance Led
            </h2>
            <p class="mt-3 text-sm leading-6 text-[#514a3f]">
              Small frontend surface, native webview shell, and startup budgets
              baked into the architecture from day one.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
