export default function HomePage() {
  return (
    <div className="card">
      <h1>Welcome to Pips Storage</h1>
      <p className="muted">
        Create apps, issue scoped API keys, and store records and files. Your data is kept in a
        private repository.
      </p>
      <div className="actions">
        <a className="btn" href="/dashboard">Go to dashboard</a>
        <a className="btn secondary" href="/login">Log in</a>
        <a className="btn secondary" href="/signup">Sign up</a>
      </div>
    </div>
  );
}
