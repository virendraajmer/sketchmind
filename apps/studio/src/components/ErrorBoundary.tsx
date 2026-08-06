import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Catches render-time crashes (e.g. Konva failing on an unsupported canvas)
 * so the failure shows as a message instead of a silent blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("SketchMind crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="m-4 rounded-lg border border-danger bg-surface p-4 text-danger">
        <p className="m-0 font-semibold">Something went wrong.</p>
        <p className="mt-1 mb-0 text-sm">{error.message}</p>
      </div>
    );
  }
}
