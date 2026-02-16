import React from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";

const root = createRoot(document.getElementById("root")!);
root.render(React.createElement(AdminApp));
