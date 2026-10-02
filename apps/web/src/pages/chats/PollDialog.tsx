import { Button, Dialog, TextField } from '@tessera/ui';
import { useState, type ReactNode, type SubmitEvent } from 'react';

import { MAX_POLL_OPTIONS } from '../../messaging/content.js';

export function PollDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], multiple: boolean) => void;
}): ReactNode {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const filled = options.filter((option) => option.trim() !== '');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (question.trim() === '' || filled.length < 2) return;
    onCreate(question, filled, multiple);
    setQuestion('');
    setOptions(['', '']);
    setMultiple(false);
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title="New poll">
      <form className="stack" onSubmit={submit}>
        <TextField
          label="Question"
          required
          maxLength={300}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {options.map((option, index) => (
          <TextField
            key={index}
            label={`Option ${index + 1}`}
            maxLength={100}
            value={option}
            onChange={(e) => setOptions(options.map((o, i) => (i === index ? e.target.value : o)))}
          />
        ))}
        {options.length < MAX_POLL_OPTIONS ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOptions([...options, ''])}
          >
            Add option
          </Button>
        ) : null}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={multiple}
            onChange={(e) => setMultiple(e.target.checked)}
          />
          Allow more than one answer
        </label>
        <div className="button-row">
          <Button type="submit" disabled={question.trim() === '' || filled.length < 2}>
            Send poll
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
