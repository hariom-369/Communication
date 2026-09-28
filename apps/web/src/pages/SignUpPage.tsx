import { CURRENT_TERMS_VERSION, signupRequestSchema } from '@tessera/validation';
import { Alert, Button, TextField } from '@tessera/ui';
import { useState, type SubmitEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { ApiError, errorMessage, fieldErrors } from '../api/client.js';
import { endpoints } from '../api/endpoints.js';
import { AuthLayout } from '../components/AuthLayout.js';
import { PageHeading } from '../components/PageHeading.js';

export function SignUpPage(): ReactNode {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    const parsed = signupRequestSchema.safeParse({
      email,
      username,
      confirmsAdult: adult ? true : undefined,
      acceptedTermsVersion: terms ? CURRENT_TERMS_VERSION : undefined,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      if (next['confirmsAdult'] !== undefined)
        next['confirmsAdult'] = 'You must be 18 or older to use Tessera.';
      if (next['acceptedTermsVersion'] !== undefined)
        next['acceptedTermsVersion'] = 'Please accept the Terms and Privacy Notice.';
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await endpoints.signup(parsed.data);
      await navigate('/verify-email', { state: { email: parsed.data.email } });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'USERNAME_TAKEN')
        setErrors({ username: 'That username is taken.' });
      else {
        setErrors(fieldErrors(caught));
        setError(errorMessage(caught));
      }
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      footer={
        <p>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <PageHeading description="Private messaging you control.">Create your account</PageHeading>
      <form className="stack" noValidate onSubmit={(event) => void submit(event)}>
        {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors['email']}
        />
        <TextField
          label="Username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint="5–32 lower-case letters, digits or underscores. People can find you by it."
          error={errors['username']}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={adult}
            onChange={(e) => setAdult(e.target.checked)}
            aria-describedby="adult-error"
          />
          <span>I am 18 years or older.</span>
        </label>
        {errors['confirmsAdult'] === undefined ? null : (
          <p id="adult-error" className="field-error">
            {errors['confirmsAdult']}
          </p>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            aria-describedby="terms-error"
          />
          <span>
            I accept the Terms of Service and Privacy Notice (draft {CURRENT_TERMS_VERSION}).
          </span>
        </label>
        {errors['acceptedTermsVersion'] === undefined ? null : (
          <p id="terms-error" className="field-error">
            {errors['acceptedTermsVersion']}
          </p>
        )}
        <Button type="submit" loading={busy} loadingLabel="Creating account">
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}
