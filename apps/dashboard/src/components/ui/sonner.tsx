import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/** §8.1 design-systemu: wynik akcji ("Zatwierdzono", "Odrzucono", "Token skopiowany"). Motyw czyta
 * `data-theme`/OS tak samo jak reszta appki — `theme="system"` + nasze CSS variables w `--normal-*`. */
function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-center"
      toastOptions={{
        classNames: {
          toast:
            'rounded-lg border border-border-strong bg-surface text-foreground shadow-md text-sm',
          description: 'text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
