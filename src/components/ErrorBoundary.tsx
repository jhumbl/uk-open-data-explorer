import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * One broken dashboard must never take down the catalogue (site
 * invariant 5) — every dashboard route renders inside this boundary.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="notice" role="alert">
          <strong>This dashboard failed to load.</strong>
          <br />
          {this.state.error.message}
          <br />
          The underlying dataset is unaffected — the rest of the catalogue
          still works, and the data itself is served from Hugging Face.{" "}
          <a href="#/">Back to the catalogue</a>.
        </div>
      );
    }
    return this.props.children;
  }
}
