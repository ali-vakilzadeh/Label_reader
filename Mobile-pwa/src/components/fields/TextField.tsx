import React, { useId } from 'react';
import { FieldShell, FIELD_BASE, FIELD_CLASS, fieldStateFor } from './FieldShell';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  confidence?: number;
  disabled?: boolean;
  required?: boolean;
  hint?: string;
  mono?: boolean;
}

/**
 * A free-text field: size, price, the weights, the care URL. These belong to no table,
 * are never matched and are never translated in either direction (contract section 8.4),
 * so there is no picker and no Armenian rendering - what the label said is what shows.
 */
export const TextField: React.FC<TextFieldProps> = ({
  label,
  value,
  onChange,
  placeholder,
  confidence,
  disabled = false,
  required = false,
  hint,
  mono = false
}) => {
  const id = useId();
  const state = fieldStateFor(confidence, disabled);

  return (
    <FieldShell
      label={label}
      required={required}
      confidence={confidence}
      empty={!value.trim()}
      hint={hint}
      htmlFor={id}
    >
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${FIELD_BASE} ${FIELD_CLASS[state]} ${mono ? 'font-mono' : ''}`}
      />
    </FieldShell>
  );
};
