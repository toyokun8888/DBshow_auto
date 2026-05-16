import { useState } from "react";
import "./App.css";

import SellerCompletionPage from "./features/sellerCompletion/SellerCompletionPage";
import LibraryPage from "./features/library/LibraryPage";
import RapidgatorResearchPage from "./features/rapidgatorResearch/RapidgatorResearchPage";

type TabKey = "library" | "sellerCompletion" | "rapidgatorResearch";

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

        <button
          onClick={() => setTab("rapidgatorResearch")}
          style={{
            padding: "10px 14px",
            cursor: "pointer",
            background: tab === "rapidgatorResearch" ? "#8b5cf6" : "#222",
            color: "#fff",
            border: "1px solid #555",
            borderRadius: "8px",
          }}
        >
          Rapidgator Research
        </button>
      </header>

      {tab === "library" && <LibraryPage />}
      {tab === "sellerCompletion" && <SellerCompletionPage />}
      {tab === "rapidgatorResearch" && <RapidgatorResearchPage />}
    </div>
  );
}

export default App;