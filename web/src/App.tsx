import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Footer, Header } from "./components/Header";
import { LaunchPage } from "./pages/Launch";
import { MarketsPage } from "./pages/Markets";
import { SwapPage } from "./pages/Swap";
import { DexProvider } from "./state/dex";
import { ToastProvider } from "./state/toast";
import { WalletProvider } from "./state/wallet";

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <WalletProvider>
          <DexProvider>
            <div className="app">
              <Header />
              <Routes>
                <Route path="/" element={<Navigate to="/swap" replace />} />
                <Route path="/swap" element={<SwapPage />} />
                <Route path="/markets/:base?/:quote?" element={<MarketsPage />} />
                <Route path="/launch" element={<LaunchPage />} />
                <Route path="*" element={<Navigate to="/swap" replace />} />
              </Routes>
              <Footer />
            </div>
          </DexProvider>
        </WalletProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
