import type { ChangeEvent, ReactNode } from "react";
import BackButton from "../components/BackButton";
import PageLoadingScreen from "../components/ui/PageLoadingScreen";

type ContentShellProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
};

export function ContentShell({
  eyebrow = "Valorant",
  title,
  subtitle,
  className = "",
  children,
}: ContentShellProps) {
  return (
    <main className={`content-page ${className}`.trim()}>
      <BackButton />
      <header className="content-header">
        <span className="content-eyebrow">{eyebrow}</span>
        <h1 className="content-title">{title}</h1>
        <div className="content-divider" />
        {subtitle && <p className="content-subtitle">{subtitle}</p>}
      </header>
      {children}
    </main>
  );
}

export function ContentLoading(props: {
  title?: string;
  message?: string;
}) {
  void props;
  return <PageLoadingScreen />;
}

export function ContentError({
  title = "No se pudo cargar",
  message = "Ha fallado la carga de contenido.",
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="content-state-card content-state-card--error">
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry && (
        <button className="content-primary-btn" type="button" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function ContentEmpty({
  message = "No hay contenido disponible.",
}: {
  message?: string;
}) {
  return (
    <div className="content-state-card">
      <h2>Sin resultados</h2>
      <p>{message}</p>
    </div>
  );
}

export function ContentSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="content-section">
      <h2 className="content-section-title">{title}</h2>
      {children}
    </section>
  );
}

export function ClearableSearchInput({
  className = "",
  inputClassName = "",
  value,
  onChange,
  onClear,
  placeholder,
  ariaLabel,
  onFocus,
  onBlur,
}: {
  className?: string;
  inputClassName?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const hasValue = value.trim().length > 0;

  return (
    <span className={`content-search-wrap ${className}`.trim()}>
      <input
        className={`content-search ${inputClassName}`.trim()}
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      {hasValue && (
        <button
          className="content-search-clear"
          type="button"
          aria-label="Borrar busqueda"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClear}
        >
          <span aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
