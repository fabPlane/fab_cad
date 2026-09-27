export default async function globalTeardown(): Promise<void> {
  const pid = Number(process.env.FREECAD_API_SERVER_PID);
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}
