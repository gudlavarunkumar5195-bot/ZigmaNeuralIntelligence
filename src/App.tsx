import { Suspense } from "react";
import { RouterProvider } from "react-router";
import { router } from "./router";

function AppLoading() {
  return (
    <main className="min-h-screen grid place-items-center bg-slate-50 text-sm text-slate-500">
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">Loading ZigmaNeural…</div>
    </main>
  );
}

export default function App() {
  return <Suspense fallback={<AppLoading />}><RouterProvider router={router} /></Suspense>;
}
