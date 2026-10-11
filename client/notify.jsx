// Toast notices, bottom right. Kept short: at most four, and they dismiss themselves.
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const NotifyContext = createContext(() => {});

export function NoticesProvider({ children }) {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);

  const notify = useCallback((kind, message, withLogin) => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, kind, message, withLogin: !!withLogin }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
    }, kind === 'success' ? 6000 : 10000);
  }, []);

  const dismiss = (id) => setItems((prev) => prev.filter((x) => x.id !== id));

  return (
    <NotifyContext.Provider value={notify}>
      {children}
      <div className="notices" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={'notice ' + item.kind} role={item.kind === 'error' ? 'alert' : 'status'}>
            <span>
              {item.message}
              {item.withLogin ? (
                <>
                  {' '}
                  <a href="/login">Log in</a>
                </>
              ) : null}
            </span>
            <button type="button" className="linklike" onClick={() => dismiss(item.id)}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  return useContext(NotifyContext);
}
