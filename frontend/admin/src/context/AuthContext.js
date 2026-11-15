import React, { createContext, useState, useEffect } from "react";
import axios from "../api/axios"; // axios instance with base URL

export const AuthContext = createContext();

export function AuthProvider({ children }) {
  // Read the session synchronously so a page refresh keeps the user on the same route
  // (previously state started as null and every refresh bounced to /login).
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem("user");
      return u && localStorage.getItem("token") ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });
  const [token, setToken] = useState(() => localStorage.getItem("token"));

  // Check localStorage for user and token on mount
  useEffect(() => {
    const savedUser = localStorage.getItem("user");
    const savedToken = localStorage.getItem("token");

    if (savedUser && savedToken) {
      setUser(JSON.parse(savedUser));
      setToken(savedToken);

      // Optionally, you could check for token expiry here if needed
    }
  }, []);

  // Login function
  const login = async (employeeID, password) => {
    const res = await axios.post("/adminauth/admin/login", { employeeID, password });
    console.log("res.data : ", res);
    
    setUser(res.data.user);
    setToken(res.data.token);
    localStorage.setItem("user", JSON.stringify(res.data.user));
    localStorage.setItem("token", res.data.token);
  };

  // Logout function
  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("user");
    localStorage.removeItem("token");
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
