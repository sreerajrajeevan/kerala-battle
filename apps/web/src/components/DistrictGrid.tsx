import { KERALA_DISTRICTS, type KeralaDistrict } from '@kerala-battle/shared';

interface DistrictGridProps {
  selected: KeralaDistrict | null;
  onSelect: (district: KeralaDistrict) => void;
}

export default function DistrictGrid({ selected, onSelect }: DistrictGridProps) {
  return (
    <div className="district-grid" role="group" aria-label="Select your district">
      {KERALA_DISTRICTS.map((district) => (
        <button
          key={district}
          type="button"
          className={district === selected ? 'district-btn selected' : 'district-btn'}
          aria-pressed={district === selected}
          onClick={() => onSelect(district)}
        >
          {district}
        </button>
      ))}
    </div>
  );
}
