// The React app entry. The server sends a small shell with a JSON bootstrap block;
// this file renders the whole logged-in app: the top menu and the page.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { NoticesProvider } from './notify.jsx';
import { BoxIcon, HomeIcon, CompassIcon, LogoutIcon, UserIcon, PlayIcon, ChatIcon } from './icons.jsx';
import HomePage from './Home.jsx';
import ExplorePage from './Explore.jsx';
import TubePage from './Tube.jsx';
import ChatPage from './Chat.jsx';

function TopNav({ page, username }) {
  async function logout(e) {
    e.preventDefault();
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/';
  }
  const link = (href, key, icon, label) => (
    <a className={'nav-link' + (page === key ? ' active' : '')} href={href}>
      {icon}
      <span>{label}</span>
    </a>
  );
  return (
    <nav className="top">
      <a className="brand" href="/home">
        <BoxIcon size={20} />
        <span>File Vault</span>
      </a>
      <div className="nav-links">
        {link('/home', 'home', <HomeIcon />, 'Home')}
        {link('/explore', 'explore', <CompassIcon />, 'Explore')}
        {link('/tube', 'tube', <PlayIcon size={16} />, 'Tube')}
        {link('/chat', 'chat', <ChatIcon size={16} />, 'Chat')}
      </div>
      <div className="nav-right">
        <span className="user-chip" title="Signed in">
          <UserIcon />
          <span>{username}</span>
        </span>
        <button type="button" className="nav-logout" onClick={logout}>
          <LogoutIcon />
          <span>Log out</span>
        </button>
      </div>
    </nav>
  );
}

function App({ boot }) {
  // Every Tube screen (feed, watch, channel) highlights the one Tube nav link.
  const active = typeof boot.page === 'string' && boot.page.indexOf('tube') === 0 ? 'tube' : boot.page;
  return (
    <NoticesProvider>
      <TopNav page={active} username={boot.user.username} />
      {boot.page === 'home' ? (
        <HomePage user={boot.user} filesEnabled={boot.filesEnabled} maxBytes={boot.maxBytes} />
      ) : boot.page === 'explore' ? (
        <ExplorePage
          user={boot.user}
          filesEnabled={boot.filesEnabled}
          maxBytes={boot.maxBytes}
          linkMaxFiles={boot.linkMaxFiles}
          linkMaxBytes={boot.linkMaxBytes}
        />
      ) : boot.page === 'chat' ? (
        <ChatPage boot={boot} />
      ) : (
        <TubePage boot={boot} />
      )}
    </NoticesProvider>
  );
}

const box = document.getElementById('app-bootstrap');
const root = document.getElementById('root');
if (box && root) {
  createRoot(root).render(<App boot={JSON.parse(box.textContent)} />);
}
