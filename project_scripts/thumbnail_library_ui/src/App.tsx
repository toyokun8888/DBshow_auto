import { useState } from "react";
import "./App.css";

import SellerCompletionPage from "./features/sellerCompletion/SellerCompletionPage";
import LibraryPage from "./features/library/LibraryPage";

type TabKey = "library" | "sellerCompletion";

function App() {
  const [tab, setTab] = useState<TabKey>("sellerCompletion");

  return (
    <div>
      <header
        style={{
          display: "flex",
          gap: "8px",
          padding: "12px",
          borderBottom: "1px solid #333",
          background: "#111",
        }}
      >
        <button
          onClick={() => setTab("library")}
          style={{
            padding: "10px 14px",
            cursor: "pointer",
            background: tab === "library" ? "#4460ff" : "#222",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: "8px",
          }}
        >
          Local Library
        </button>

        <button
          onClick={() => setTab("sellerCompletion")}
          style={{
            padding: "10px 14px",
            cursor: "pointer",
            background: tab === "sellerCompletion" ? "#4460ff" : "#222",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: "8px",
          }}
        >
          Seller Completion
        </button>
      </header>

      {tab === "library" ? <LibraryPage /> : <SellerCompletionPage />}
    </div>
  );
}

export default App;