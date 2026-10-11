// The upload and import queue. Each row is a mutable task object; the list re-renders
// whenever a handle updates it. The handle interface matches the old imperative client
// (progress, indeterminate, state, cancelable, done, fail, noCancel) so the upload and
// import engines keep their exact behavior.
import React, { useCallback, useReducer, useRef } from 'react';
import { uuid } from './api.js';

export function useTasks() {
  const [, bump] = useReducer((x) => x + 1, 0);
  const listRef = useRef([]);

  const add = useCallback((title, sizeText) => {
    const task = {
      id: uuid(),
      title,
      sizeText: sizeText || '',
      progress: 0,
      indeterminate: false,
      stateText: 'Waiting…',
      kind: '',
      onCancel: null,
      retryFn: null,
      done: false,
    };
    listRef.current = [...listRef.current, task];

    const handle = {
      progress(fraction) {
        task.indeterminate = false;
        task.progress = Math.max(0, Math.min(1, fraction));
        bump();
      },
      indeterminate() {
        task.indeterminate = true;
        bump();
      },
      state(text, kind) {
        task.stateText = text;
        task.kind = kind || '';
        task.onCancel = null;
        bump();
      },
      cancelable(onCancel) {
        task.onCancel = () => {
          task.onCancel = null;
          bump();
          onCancel();
        };
        bump();
      },
      done(text) {
        task.onCancel = null;
        task.retryFn = null;
        task.indeterminate = false;
        task.progress = 1;
        task.stateText = text || 'Done';
        task.kind = 'done';
        task.done = true;
        bump();
        setTimeout(() => {
          listRef.current = listRef.current.filter((t) => t !== task);
          bump();
        }, 4000);
      },
      fail(message, retry) {
        task.onCancel = null;
        task.indeterminate = false;
        task.stateText = message;
        task.kind = 'error';
        task.retryFn = retry || null;
        bump();
      },
      noCancel() {
        task.onCancel = null;
        bump();
      },
    };
    return handle;
  }, []);

  return { tasks: listRef.current, add };
}

// One row: name, size, progress bar, state, and optional Cancel and Retry buttons.
export function TaskRow({ task }) {
  return (
    <li className={'queue-item' + (task.done ? ' done' : '')}>
      <span className="queue-name">
        {task.title}
        {task.sizeText ? <span className="queue-size"> · {task.sizeText}</span> : null}
      </span>
      <progress
        max="1"
        value={task.indeterminate ? undefined : task.progress}
        aria-label={'Progress for ' + task.title}
      />
      <span>
        <span className={'queue-state ' + task.kind}>{task.stateText}</span>{' '}
        {task.onCancel ? (
          <button type="button" className="linklike" onClick={task.onCancel} aria-label={'Cancel ' + task.title}>
            Cancel
          </button>
        ) : null}
        {task.kind === 'error' && task.retryFn ? (
          <button type="button" className="linklike" onClick={task.retryFn}>
            Retry
          </button>
        ) : null}
      </span>
    </li>
  );
}

export function TaskList({ tasks, label }) {
  return (
    <ul className="queue" aria-label={label}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}
