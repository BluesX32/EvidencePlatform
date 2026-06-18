import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface ReviewerView {
  reviewerId: string;
  reviewerName: string;
  projectId: string;
}

interface ReviewerViewContextValue {
  reviewerView: ReviewerView | null;
  enterReviewerView: (projectId: string, reviewerId: string, reviewerName: string) => void;
  exitReviewerView: () => void;
}

const ReviewerViewContext = createContext<ReviewerViewContextValue>({
  reviewerView: null,
  enterReviewerView: () => {},
  exitReviewerView: () => {},
});

const STORAGE_KEY = "ep_reviewer_view";

function loadFromStorage(): ReviewerView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function ReviewerViewProvider({ children }: { children: ReactNode }) {
  const [reviewerView, setReviewerView] = useState<ReviewerView | null>(loadFromStorage);

  const enterReviewerView = useCallback((projectId: string, reviewerId: string, reviewerName: string) => {
    const val = { projectId, reviewerId, reviewerName };
    setReviewerView(val);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
  }, []);

  const exitReviewerView = useCallback(() => {
    setReviewerView(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <ReviewerViewContext.Provider value={{ reviewerView, enterReviewerView, exitReviewerView }}>
      {children}
    </ReviewerViewContext.Provider>
  );
}

export function useReviewerView() {
  return useContext(ReviewerViewContext);
}
