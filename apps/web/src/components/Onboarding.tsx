import { useState, type FormEvent } from 'react';
import type { KeralaDistrict, PlayerProfile } from '@kerala-battle/shared';
import { createProfile, isValidDisplayName } from '../lib/profile';
import DistrictGrid from './DistrictGrid';

interface OnboardingProps {
  onComplete: (profile: PlayerProfile) => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [displayName, setDisplayName] = useState('');
  const [district, setDistrict] = useState<KeralaDistrict | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const nameValid = isValidDisplayName(displayName);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!nameValid || district === null) return;
    onComplete(createProfile(displayName, district));
  };

  return (
    <main className="page">
      <h1>Kerala Battle</h1>
      <p className="subtitle">Choose your name and home district to enter.</p>
      <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            maxLength={20}
            placeholder="e.g. Sree"
            autoComplete="nickname"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        {submitted && !nameValid && (
          <p className="error" role="alert">
            Name must be 2–20 characters: letters, numbers and spaces only.
          </p>
        )}
        <span className="field-label">Home district</span>
        <DistrictGrid selected={district} onSelect={setDistrict} />
        {submitted && district === null && (
          <p className="error" role="alert">
            Pick one district.
          </p>
        )}
        <button type="submit" className="primary-btn">
          Enter Kerala Battle
        </button>
      </form>
    </main>
  );
}
