"""
Simple test script to verify Selenium can scrape one event
Run this first to make sure everything works
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import time

TEST_URL = 'https://caleprocure.ca.gov/event/0531/0000037891'

def test_selenium_scrape():
    print(f"Testing Selenium scrape on: {TEST_URL}")
    print("=" * 80)
    
    # Set up Chrome
    options = webdriver.ChromeOptions()
    # Run with browser visible so you can see what's happening
    # options.add_argument('--headless')  # Uncomment to hide browser
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 15)
    
    try:
        # Load the page
        print("\n1. Loading page...")
        driver.get(TEST_URL)
        
        # Wait for JavaScript to load data
        print("2. Waiting for JavaScript to populate data...")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        
        # Give extra time for all data to load
        time.sleep(3)
        
        print("\n3. Extracting data...")
        print("-" * 80)
        
        # Extract title
        try:
            title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
            title = title_elem.text.strip()
            print(f"Title: {title}")
        except:
            print("Title: NOT FOUND")
        
        # Extract description
        try:
            desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
            desc = desc_elem.text.strip()
            print(f"Description (first 200 chars): {desc[:200]}...")
        except:
            print("Description: NOT FOUND")
        
        # Extract contact name
        try:
            contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
            contact = contact_elem.text.strip()
            print(f"Contact Name: {contact}")
        except:
            print("Contact Name: NOT FOUND")
        
        # Extract email
        try:
            email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
            email = email_elem.text.strip()
            print(f"Email: {email}")
        except:
            try:
                email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
                email = email_elem.text.strip()
                print(f"Email (alternate): {email}")
            except:
                print("Email: NOT FOUND")
        
        # Extract phone
        try:
            phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
            phone = phone_elem.text.strip()
            print(f"Phone: {phone}")
        except:
            print("Phone: NOT FOUND")
        
        # Extract dept
        try:
            dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
            dept = dept_elem.text.strip()
            print(f"Department: {dept}")
        except:
            print("Department: NOT FOUND")
        
        print("-" * 80)
        print("\n✓ Test complete! If you see actual data above (not placeholders),")
        print("  then Selenium is working and you can run the full scraper.")
        print("\nPress Ctrl+C when you're done examining the browser window.")
        
        # Keep browser open so you can inspect
        input("\nPress Enter to close browser...")
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    test_selenium_scrape()