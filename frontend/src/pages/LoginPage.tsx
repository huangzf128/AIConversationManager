import { useNavigate } from 'react-router-dom';
import './LoginPage.css';

function LoginPage() {
  const navigate = useNavigate();

  const handleLogin = () => {
    // No real authentication yet — just jump straight to the main page.
    navigate('/mypage');
  };

  return (
    <div className="login-page">
      <div>
        <h1>AI Conversation Manager</h1>
        <button onClick={handleLogin}>Log in</button>
      </div>
    </div>
  );
}

export default LoginPage;